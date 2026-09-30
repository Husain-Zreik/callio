// WebRTC for the SDK. CallioAgent creates peer connections and gets the
// microphone through this, so tests can pass fakes; FlutterWebrtcMedia is the
// real one (flutter_webrtc).
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

abstract class CallioMedia {
  Future<rtc.RTCPeerConnection> createPeerConnection(Map<String, dynamic> configuration);

  /// The microphone.
  Future<rtc.MediaStream> getMicrophone();
}

class FlutterWebrtcMedia implements CallioMedia {
  const FlutterWebrtcMedia({this.audioConstraints = defaultAudio});

  static const Map<String, dynamic> defaultAudio = {
    'echoCancellation': true,
    'noiseSuppression': true,
    'autoGainControl': true,
  };

  final Map<String, dynamic> audioConstraints;

  @override
  Future<rtc.RTCPeerConnection> createPeerConnection(Map<String, dynamic> configuration) =>
      rtc.createPeerConnection({'sdpSemantics': 'unified-plan', ...configuration});

  @override
  Future<rtc.MediaStream> getMicrophone() =>
      rtc.navigator.mediaDevices.getUserMedia({'audio': audioConstraints, 'video': false});
}
