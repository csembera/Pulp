// Stub Web Streams API — not available in Node 16 but required by the Bedrock SDK's
// WebSocket middleware import path. Tests mock the client so the real API is never called.
if (typeof global.TransformStream === 'undefined') {
  global.TransformStream = class TransformStream {};
}
if (typeof global.ReadableStream === 'undefined') {
  global.ReadableStream = class ReadableStream {};
}
if (typeof global.WritableStream === 'undefined') {
  global.WritableStream = class WritableStream {};
}
