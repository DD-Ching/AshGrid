#!/usr/bin/env python3
# AshGrid local dev server — replaces `python3 -m http.server` so the ONNX
# wasm runtime can use multi-threaded SIMD inference.
#
# Why: ONNX Runtime Web's wasm backend warns
#   "env.wasm.numThreads is set to 4, but this will not work unless you
#    enable crossOriginIsolated mode."
# Without the COOP/COEP headers below, the browser blocks
# SharedArrayBuffer (which the threaded wasm needs) and falls back to
# single-threaded inference. Result on this game: ~30 fps cap with 5+
# NN bots even on fast machines.
#
# Sending these two headers unlocks crossOriginIsolated mode:
#   Cross-Origin-Opener-Policy: same-origin
#   Cross-Origin-Embedder-Policy: require-corp
#
# On the Crazy Games portal these headers are sent automatically, so this
# only matters during local dev. Standard `python3 -m http.server` doesn't
# send them — hence this 12-line wrapper.
#
# Usage:
#   python3 serve.py
#   # opens http://localhost:8765/

import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class CrossOriginIsolatedHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        # Reasonable for dev — caches busted every reload via ?t= URL param
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    with socketserver.TCPServer(('', PORT), CrossOriginIsolatedHandler) as httpd:
        print(f'AshGrid dev server on http://localhost:{PORT}/ (crossOriginIsolated enabled)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nshutdown')
