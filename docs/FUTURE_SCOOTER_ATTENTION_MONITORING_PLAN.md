# Scooter Attention Monitoring Plan

## Goal

Add an opt-in riding mode that uses the iPhone selfie camera to estimate whether
the rider's face and gaze remain forward while riding a scooter. When attention
appears to drift for more than a short threshold, Family OS should notify the
paired Apple Watch with a strong haptic alert.

This is a personal safety aid, not an autonomous-driving feature, medical
feature, or guarantee that the rider is safe.

## Product Scope

### MVP

- A new `Ride` or `Safety` entry point in the iOS app.
- A full-screen `Scooter Attention` session view that must stay foregrounded.
- Clear consent before camera use.
- Selfie-camera preview with an obvious active-monitoring state.
- On-device face analysis only.
- No photo or video upload.
- No raw image persistence.
- Attention status states:
  - `ready`
  - `face_missing`
  - `looking_forward`
  - `attention_drift`
  - `low_confidence`
- A configurable drift threshold, initially 1.5 to 2.0 seconds.
- A cooldown window, initially 8 to 12 seconds, to avoid constant buzzing.
- Apple Watch vibration when drift is sustained.
- Optional local iPhone audio/haptic fallback when no watch is reachable.

### Advanced Road Detection Mode

The app can also monitor the rear camera for road objects, but this should be an
advanced mode after the rider-attention MVP is reliable.

Scope:

- Use the rear wide camera to analyze the road ahead while the front camera
  monitors the rider.
- Detect coarse classes such as vehicle, person, bicycle, traffic cone, animal,
  and large obstacle.
- Alert only on high-confidence, close-range, path-relevant objects.
- Keep all road-frame analysis on-device.
- Do not record or upload road video by default.

Non-goals:

- Do not market this as collision avoidance.
- Do not attempt autonomous braking, steering, or lane guidance.
- Do not depend on rear-camera detection for core rider-attention alerts.
- Do not alert on every detected object; excessive alerts will train the rider to
  ignore the watch.

### Explicit Non-Goals For MVP

- Background camera monitoring.
- Monitoring while another app is in the foreground.
- Recording or storing ride video.
- Uploading face images to the backend.
- Family or caregiver surveillance.
- Scoring rider behavior historically.
- Emergency detection or crash detection.
- Turn-by-turn navigation.
- Android support.

## Safety And Privacy Constraints

- The session must require explicit start and stop actions.
- The camera indicator and in-app preview/status must make monitoring visible.
- The app should stop capture when the session ends or the app backgrounds.
- The app should explain that it cannot work if the iPhone is not mounted with a
  stable view of the rider's face.
- The app should require the rider to configure and test the phone mount before
  using this on the road.
- The app should not encourage looking at the phone while riding.
- The app should avoid storing biometric templates or face images.
- Any saved session data should be aggregate-only, for example alert count and
  session duration, and should be off by default for MVP.

Apple's platform constraints matter here:

- AVFoundation camera access requires explicit camera permission.
- iOS apps are expected to do little or nothing once backgrounded, and arbitrary
  camera processing is not a general background mode.
- App Review requires clear consent and visible/audible indication when recording
  or otherwise logging user activity, including camera input.

## Technical Approach

### iOS App

Add a local-only attention monitor service:

```text
AVCaptureSession
  -> front camera frames
  -> Vision face detection / landmarks
  -> attention classifier
  -> alert coordinator
  -> Watch haptic / local notification fallback
```

Recommended modules:

- `ScooterAttentionSessionView`
- `ScooterAttentionViewModel`
- `CameraFrameSource`
- `FaceAttentionAnalyzer`
- `RideAlertCoordinator`
- `WatchHapticClient`

The `FaceAttentionAnalyzer` should start with simple, explainable heuristics:

- Detect exactly one primary face.
- Reject low-confidence or badly framed observations.
- Use face yaw/pitch/roll where available.
- Use eye and pupil landmarks where available.
- Treat sustained face loss as attention drift only after a grace threshold.
- Smooth results over a rolling window before alerting.

Initial heuristic:

```text
looking_forward =
  face_detected
  and abs(yaw) <= yaw_threshold
  and abs(pitch) <= pitch_threshold
  and capture_quality >= minimum_quality when available
```

Tune thresholds with real mounted-device tests. Scooter vibration, helmet shape,
sunlight, sunglasses, face masks, night riding, and phone mount angle will all
affect reliability.

### Dual-Camera Road Object Detection

Simultaneous front and rear capture should use `AVCaptureMultiCamSession`, gated
behind `AVCaptureMultiCamSession.isMultiCamSupported`. If unsupported, fall back
to front-camera attention monitoring only.

Dual-camera pipeline:

```text
AVCaptureMultiCamSession
  -> front camera frames -> Vision face detection -> attention classifier
  -> rear camera frames  -> Vision/Core ML object detector -> road risk filter
  -> alert coordinator -> Apple Watch haptic / local fallback
```

Recommended additional modules:

- `MultiCameraFrameSource`
- `RoadObjectAnalyzer`
- `RoadRiskFilter`
- `CapturePressureMonitor`

The rear-camera detector should start conservative:

- Run rear detection at a lower frame rate than face monitoring.
- Prefer coarse object classes over fine-grained recognition.
- Require confidence, object size, and central path relevance before alerting.
- Suppress repeated alerts for the same apparent object.
- Treat poor light, rain, motion blur, and camera obstruction as low confidence.

The capture layer must observe capture-device system pressure. If pressure rises,
the app should reduce rear-camera frame rate first, then reduce rear analysis
resolution, then disable road detection while preserving front-camera attention
monitoring. Apple's capture system can interrupt or shut down capture under
excessive pressure, especially when multiple cameras and ML workloads run for a
long ride.

### Apple Watch Alerting

Use the lowest-complexity path first:

1. If iPhone notifications mirror to the paired Apple Watch reliably during a
   foreground ride session, deliver a time-sensitive local notification from the
   iPhone.
2. If direct haptic control is needed, add a watchOS app target and use
   WatchConnectivity for a reachable watch session, with a local watch
   notification or haptic playback on message receipt.

The MVP should verify watch behavior on a real iPhone plus Apple Watch. Simulator
verification is not enough for haptic behavior.

### Backend

No backend is required for MVP.

If session summaries are added later, create a separate safety facet API prefix
instead of mixing this into `/health/v1`:

```text
/safety/v1/rides
/safety/v1/rides/:id/events
```

Store only derived event metadata, never raw frames.

## Permissions And Entitlements

Required iOS permission:

- `NSCameraUsageDescription`

Likely future capabilities if a watchOS target is added:

- Watch app target.
- WatchConnectivity framework.
- Notification authorization.

The existing app already has notification delegate plumbing for APNs reminder
notifications. This feature should use local notifications or watch connectivity
first because attention alerts are generated on-device in real time.

## UX Notes

- The ride screen should be glance-free: large status, strong color states, and a
  single stop control.
- Setup should happen before riding: mount angle, face visible, watch reachable,
  test vibration.
- During a ride, the iPhone UI should not ask the rider to interact.
- Use watch haptics as the primary alert because they do not require looking away
  from the road.
- Do not display gamified safety scores in MVP.

## Validation Plan

1. Unit-test attention state smoothing and cooldown logic.
2. Run camera analyzer on recorded local test clips during development, with
   clips kept out of git.
3. Test on a mounted iPhone in daylight, night, helmet, sunglasses, and bumpy-road
   conditions.
4. Test no-watch and unreachable-watch fallbacks.
5. Test backgrounding: capture must stop and the UI must clearly show monitoring
   is no longer active when reopened.
6. Test battery and heat over a 20 to 30 minute session.
7. Test dual-camera support on each target iPhone model.
8. Test road detection false positives in traffic, parked-vehicle rows, potholes,
   pedestrians at the roadside, rain, night glare, and direct sunlight.
9. Test system-pressure fallback from dual-camera mode to front-camera-only mode.

## Implementation Slices

1. Add camera permission copy and a foreground ride session screen.
2. Build `CameraFrameSource` with front-camera preview and lifecycle cleanup.
3. Build `FaceAttentionAnalyzer` with Vision face observations.
4. Add smoothing, drift threshold, cooldown, and local alert coordinator.
5. Verify local iPhone notification/haptic fallback.
6. Verify paired Apple Watch notification mirroring on device.
7. Add a watchOS target only if notification mirroring is not strong or immediate
   enough for the riding use case.
8. Add `AVCaptureMultiCamSession` support behind an `isMultiCamSupported` gate.
9. Add low-rate rear-camera road object detection with conservative alert rules.
10. Add system-pressure monitoring and fallback to front-camera-only monitoring.
11. Add optional aggregate session summary storage after the safety behavior is
   reliable.

## Open Questions

- Where will the iPhone be mounted on the scooter?
- Does that mount let the front camera see the rider and the rear camera see the
  road at the same time?
- Which iPhone model will run this? Multi-camera support varies by hardware.
- Will the rider wear a full-face helmet, half helmet, sunglasses, or mask?
- Is a foreground iPhone app acceptable for the riding flow?
- Is Apple Watch notification mirroring enough, or do we need a companion watchOS
  target for stronger direct haptics?
- Which road objects should trigger a watch alert, and which should only be shown
  on-screen before the ride starts?
- Should Family OS save aggregate ride summaries, or should MVP leave no history?
