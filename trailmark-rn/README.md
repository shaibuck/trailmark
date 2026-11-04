# Trailmark (React Native / Expo)

Walk and run tracker. Records distance, time and pace, and keeps recording with the screen locked or the app closed.

## What you need
- A Mac with Xcode installed (from the App Store)
- Node.js 20 or newer
- An iPhone and a cable
- An Apple ID (free works, but the app then expires after 7 days and needs reinstalling)

## Steps

1. Create a blank Expo project:

       npx create-expo-app@latest trailmark --template blank
       cd trailmark

2. Install the libraries (this picks versions that match your Expo version):

       npx expo install expo-location expo-task-manager @react-native-async-storage/async-storage react-native-svg react-native-safe-area-context

3. Replace `App.js` and `app.json` in the project with the two files from this folder.
   In `app.json`, change `com.example.trailmark` (iOS and Android) to an ID of your own, such as `com.yourname.trailmark`.

4. On the iPhone, turn on Developer Mode: Settings > Privacy & Security > Developer Mode, then restart.

5. Build and install on the phone:

       npx expo run:ios --device

   The first time, Xcode may need a signing team. Open `ios/trailmark.xcworkspace`, select the Trailmark target,
   open Signing & Capabilities, and pick your Apple ID as the Team. Then run the command again.

6. On first launch, allow location. When asked, choose "Always" (or "Change to Always Allow" when iOS offers it later).
   Without "Always", tracking stops when you leave the app.

## Free route: no Mac, no paid account
GitHub builds the app for free on a Mac in the cloud, then a free tool signs it with your free Apple ID and installs it.
You need a Windows PC (or any computer that can run Sideloadly). The app expires after 7 days; repeat step 6 to refresh it.

1. Make a free GitHub account and create a new public repository (public repos get free build time).
2. Upload this folder's contents to it, keeping the structure: `App.js`, `app.json`, and `.github/workflows/build-ios.yml`.
3. Open the repository's Actions tab, choose "Build iOS app", and press "Run workflow". It takes about 15 to 30 minutes.
4. When it finishes, open the run and download the `trailmark-ipa` artifact, then unzip it to get `Trailmark.ipa`.
5. On the PC, install iTunes and iCloud from Apple's website (not the Microsoft Store versions), then install Sideloadly (sideloadly.io).
6. Connect the iPhone, open Sideloadly, drag in `Trailmark.ipa`, sign in with your Apple ID, and press Start.
7. On the iPhone: turn on Developer Mode (Settings > Privacy & Security), then trust the app under
   Settings > General > VPN & Device Management. Open Trailmark and choose "Always" for location.

If the build fails, open the failed step in the Actions log and send me the error text.

## No Mac? Build in the cloud with EAS
Expo's EAS Build service compiles the iOS app on Apple hardware for you. You can run these commands on Windows, Mac or Linux.
This route needs a paid Apple Developer Program account (about $99 a year), because Apple only allows installing
non-App-Store apps on your phone with one. The app then stays installed without the 7-day expiry.

1. Do steps 1 to 3 above (create the project, install the libraries, replace `App.js` and `app.json`), and copy `eas.json` into the project.
2. Create a free account at expo.dev, then install and sign in:

       npm install -g eas-cli
       eas login

3. Link the project:

       eas init

4. Register your iPhone (it gives you a link or QR code to open on the phone and install a small profile):

       eas device:create

5. Build for your phone (you will be asked to sign in with your Apple Developer account):

       eas build --platform ios --profile preview

6. When the build finishes, EAS prints a link and QR code. Open it on the iPhone to install Trailmark.
   Then turn on Developer Mode if iOS asks (Settings > Privacy & Security > Developer Mode).

## Trying it without a walk
In the iOS Simulator: Features > Location > City Run simulates a runner. (Avoid Freeway Drive; the app ignores
jumps faster than a person can travel.) Real background behaviour is best checked on the phone itself.

## How background tracking works
- Location readings are handled by a background task that saves them straight to storage, so they are recorded even when
  the screen is off.
- Elapsed time is computed from timestamps, not a running counter, so it stays correct while the app is closed.
- Reopening the app shows the session in progress.

## Known limits
- Not yet tested on a physical device. Expect to adjust things once you try a real walk.
- If you force-quit the app (swipe it away), iOS may stop delivering location updates until you open it again.
- Session data is stored on the phone only.
