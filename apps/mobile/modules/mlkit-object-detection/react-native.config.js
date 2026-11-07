module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath:
          'import com.taphoa.objectdetection.MlkitObjectDetectionPackage;',
        packageInstance: 'new MlkitObjectDetectionPackage()',
      },
      ios: null,
    },
  },
};
