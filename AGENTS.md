A library for 3D hand tracking that runs in a web browser with no special hardware. Possibilities to consider:

* WebXR directly provides hand input.
* Can we get RGBD from the web camera? If so, process that to get hand tracking somehow: write an algorithm, find a small trained model. I believe Mediapipe only provides 2D hands, but its 2D hands could be corresponded with the depth data. A calibration step is allowed.
* Can we read from two RGB camera at once? The user could use their laptop and iPhone cameras simultaneously. We could use that for stereo vision with a custom algorithm or two mediapipes combined epipolar-ly. A calibration step is allowed. If we can't read from two cameras at once in one browser tab, the user could open two browser tabs (on the same computer or the phone directly) that communicate peer-to-peer (websocket? WebRTC?) by sending over e.g. the mediapipe hands and calibration information.
