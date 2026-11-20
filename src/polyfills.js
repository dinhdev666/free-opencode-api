// Runtime shims for the oldest Node line this project supports.
//
// `Promise.withResolvers()` arrived in V8 12.2 (Node 22) and `@opencode/client`'s SSE subscription calls it
// unconditionally. On Node 20 that call throws `TypeError: Promise.withResolvers is not a function` inside
// `client.event.subscribe()`, and the streaming path takes its documented fallback: it polls instead. The answer is
// still correct, but every delta arrives as one chunk rather than the incremental frames the OpenAI stream contract
// promises, and the timing-sensitive behaviour built on top of it (idle timers, queue backpressure, the request
// budget) drifts with it. A runtime that has the API is left untouched.
//
// Imported for its side effect at the top of `src/proxy.js`, ahead of `@opencode/client`, so the fallback exists
// before anything can call it.

if (typeof Promise.withResolvers !== 'function') {
    Object.defineProperty(Promise, 'withResolvers', {
        value: function withResolvers() {
            let resolve;
            let reject;
            const promise = new Promise((res, rej) => {
                resolve = res;
                reject = rej;
            });
            return { promise, resolve, reject };
        },
        writable: true,
        configurable: true,
        enumerable: false
    });
}