module.exports = ({ config }) => {
  const mapsOptions = {};

  if (process.env.GOOGLE_MAPS_ANDROID_API_KEY) {
    mapsOptions.androidGoogleMapsApiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  }

  if (process.env.GOOGLE_MAPS_IOS_API_KEY) {
    mapsOptions.iosGoogleMapsApiKey = process.env.GOOGLE_MAPS_IOS_API_KEY;
  }

  const plugins = (config.plugins ?? []).filter((plugin) => {
    const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
    return pluginName !== 'react-native-maps';
  });

  plugins.push(['react-native-maps', mapsOptions]);

  plugins.push([
    'expo-image-picker',
    {
      cameraPermission: 'LUMO uses the camera to verify passenger identity for ride safety.',
      microphonePermission: false,
    },
  ]);

  plugins.push([
    'expo-splash-screen',
    {
      backgroundColor: '#F3F6F9',
      image: './assets/lumo-logo-lockup.png',
      imageWidth: 320,
      resizeMode: 'contain',
    },
  ]);

  return {
    ...config,
    ios: {
      ...config.ios,
      bundleIdentifier: config.ios?.bundleIdentifier ?? 'com.ynmadeityy.lumo',
    },
    android: {
      ...config.android,
      package: config.android?.package ?? 'com.ynmadeityy.lumo',
    },
    plugins,
  };
};
