// The socket to Callio's agent gateway. CallioAgent talks to this interface,
// so tests can script the gateway; SocketIoTransport is the real one.
import 'package:socket_io_client/socket_io_client.dart' as io;

typedef TransportHandler = void Function(dynamic payload);

abstract class CallioTransport {
  /// Connects; `auth` is called on every (re)connect for the handshake payload.
  void connect(Future<Map<String, dynamic>> Function() auth);
  void emit(String event, [Object? payload]);
  void on(String event, TransportHandler handler);

  /// 'connect', 'disconnect', 'connect_error' arrive through [on] as well.
  bool get connected;
  void close();
}

class SocketIoTransport implements CallioTransport {
  SocketIoTransport(this.url);
  final String url;
  io.Socket? _socket;
  final Map<String, List<TransportHandler>> _handlers = {};

  @override
  void connect(Future<Map<String, dynamic>> Function() auth) {
    final socket = io.io(
      url,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .disableAutoConnect()
          // One agent, one connection: never share a manager with another socket to the same URL.
          .enableForceNew()
          .setAuthFn((callback) {
            auth().then(callback, onError: (_) => callback(<String, dynamic>{}));
          })
          .build(),
    );
    _socket = socket;
    _handlers.forEach((event, handlers) {
      for (final h in handlers) {
        socket.on(event, h);
      }
    });
    socket.connect();
  }

  @override
  void emit(String event, [Object? payload]) => _socket?.emit(event, payload);

  @override
  void on(String event, TransportHandler handler) {
    (_handlers[event] ??= []).add(handler);
    _socket?.on(event, handler);
  }

  @override
  bool get connected => _socket?.connected ?? false;

  @override
  void close() {
    _socket?.dispose();
    _socket = null;
  }
}
