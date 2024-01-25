// Copyright 2018-2023 the oak authors. All rights reserved. MIT license.

import { assertEquals, unreachable } from "./test_deps.ts";

import { Server } from "./http_server_native.ts";

import { Application } from "./application.ts";
import { createPromiseWithResolvers, isNode } from "./util.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  // deno-lint-ignore no-explicit-any
  reject: (reason?: any) => void;
};

Deno.test({
  name:
    "HttpServer should not handle requests sequentially when dealing with connections over H2",
  ignore: isNode(),
  async fn() {
    const app = new Application();
    const listenOptions = {
      port: 4507,
      secure: true,
      certFile: "./examples/tls/localhost.crt",
      keyFile: "./examples/tls/localhost.key",
      alpnProtocols: ["h2"],
    };

    const server = new Server(app, listenOptions);
    server.listen();

    const requestCount = 1024;
    const requestDeferreds: Array<Deferred<void>> = [
      ...new Array(requestCount),
    ].map(() => createPromiseWithResolvers<void>());
    const responseDeferreds: Array<Deferred<void>> = [
      ...new Array(requestCount),
    ].map(() => createPromiseWithResolvers<void>());
    const requestHandlers: Array<
      (nativeRequest: unknown) => Promise<void>
    > = [];

    let responseCounter = 0;

    for (let i = 0; i < requestCount; i++) {
      // Each handler:
      // 1. Resolves it's requestDeferreds entry so the next fetch is made
      // 2. Wait for all subsequent handlers to respond first
      // 3. Responds to the request with the current response counter
      // 4. Resolves it's responseDeferreds entry so previous requests can be responded to

      // deno-lint-ignore no-explicit-any
      requestHandlers.push(async (nativeRequest: any) => {
        requestDeferreds[i].resolve();

        if (i + 1 < requestCount) {
          for (let j = requestCount; j > i; j--) {
            await responseDeferreds[j]?.promise;
          }
        }

        await nativeRequest.respond(new Response(`${responseCounter++}`));

        responseDeferreds[i].resolve();
      });
    }

    (async () => {
      for await (const nativeRequest of server) {
        requestHandlers.shift()?.(nativeRequest);
      }
    })();

    const requestUrl = `https://localhost:${listenOptions.port}`;
    const responsePromises: Promise<Response>[] = [];

    try {
      for (let i = 0; i < requestCount; i++) {
        responsePromises.push(fetch(`${requestUrl}?request=${i}`));
        // Don't make next request until sure server has received it
        // so we can later assert on order of response compared with
        // order of request.
        await requestDeferreds[i]?.promise;
      }

      const results = await Promise.all(responsePromises);

      for (let i = 0; i < requestCount; i++) {
        assertEquals(await results[i].text(), `${requestCount - i - 1}`);
      }
    } catch {
      unreachable();
    } finally {
      server.close();
    }
  },
});
