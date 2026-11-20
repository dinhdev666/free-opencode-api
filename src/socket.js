/**
 * Raw-socket helpers for the paths that answer before (or outside) Fastify's reply lifecycle.
 *
 * A hijacked response, a request the HTTP parser rejected and a URL the router cannot decode are all written straight to
 * the socket. `socket.destroy()` throws away whatever is still buffered in userland, so every close here flushes first.
 */

// How long a written response may take to leave before its socket is destroyed. `socket.destroy()` discards buffered
// writes, so a response that is written and then destroyed in the same tick can be lost entirely.
const SOCKET_CLOSE_TIMEOUT_MS = 250;

/**
 * End a socket that has just been handed a response, falling back to `destroy()` when the close never completes.
 *
 * `destroy()` throws away whatever is still buffered in userland, so a response that is written and then destroyed in
 * the same tick can be lost: the client sees a reset instead of the envelope. `end()` flushes and closes, and the
 * fallback timer only destroys a socket whose close never completes (a peer that stopped reading).
 * @param {import('net').Socket} socket
 */
export const closeSocketAfterFlush = (socket) => {
    if (!socket || socket.destroyed) return;
    // The parser sees the body of this request end in the middle of what the client announced (the gateway hung up on
    // purpose), raises HPE_INVALID_EOF_STATE and hands it to `clientErrorHandler`, which logged a warn line reading
    // "the client sent garbage" and wrote a `400` nobody would read on top of the answer that had just gone out. The
    // flag is what tells the two causes apart: this socket was closed by the gateway, not by a broken peer.
    socket.gatewayClosed = true;
    if (socket.writableEnded) {
        // Everything was already handed to the kernel by an earlier end(): there is nothing left to flush, and the
        // socket has to go now because the client is still sending a body that will never be read.
        socket.destroy();
        return;
    }
    const forceClose = () => {
        if (!socket.destroyed) socket.destroy();
    };
    const timer = setTimeout(forceClose, SOCKET_CLOSE_TIMEOUT_MS);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    try {
        socket.end();
    } catch (error) {
        forceClose();
    }
};