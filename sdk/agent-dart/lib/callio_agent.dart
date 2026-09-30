/// Callio agent SDK for Flutter: the agent side of Callio's agent protocol
/// (docs/agent-protocol.md) — calls, availability, devices, supervisor board
/// and monitoring — over Socket.IO and WebRTC (flutter_webrtc).
library;

export 'src/agent.dart' show CallioAgent, CallEnded, CallStateChange, BoardCallEnded, TokenProvider;
export 'src/call.dart' show CallioCall;
export 'src/media.dart' show CallioMedia, FlutterWebrtcMedia;
export 'src/models.dart';
export 'src/monitor.dart' show CallioMonitor;
export 'src/transport.dart' show CallioTransport, SocketIoTransport, TransportHandler;
