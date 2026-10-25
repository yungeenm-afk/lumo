# Google Maps setup

Both map screens use the Google provider on Android. iOS uses Google Maps only in a native build when an iOS key is configured; Expo Go on iOS uses its built-in map provider because its native binary does not include this project's Google Maps iOS SDK.

Add these values to the local `.env` file for local native builds, or configure them as build environment variables for EAS:

```env
GOOGLE_MAPS_ANDROID_API_KEY=your_restricted_android_key
GOOGLE_MAPS_IOS_API_KEY=your_restricted_ios_key
EXPO_PUBLIC_GOOGLE_MAPS_IOS_ENABLED=true
```

In Google Cloud, enable Maps SDK for Android and Maps SDK for iOS, enable billing, and restrict each key to LUMO's Android package/SHA-1 or iOS bundle identifier. Set the iOS flag to `true` only when the iOS key is configured, then create a new native development or production build. The Expo config plugin in `app.config.js` injects the platform keys. Leave the iOS flag unset in Expo Go; its iOS binary does not include this project's Google Maps native provider.
