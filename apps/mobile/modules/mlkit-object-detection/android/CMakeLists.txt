cmake_minimum_required(VERSION 3.22.1)
project(MlkitObjectDetection)
set(CMAKE_CXX_STANDARD 20)

add_library(MlkitObjectDetection SHARED src/main/cpp/cpp-adapter.cpp)
include(../nitrogen/generated/android/MlkitObjectDetection+autolinking.cmake)
find_package(react-native-vision-camera REQUIRED)
target_link_libraries(MlkitObjectDetection react-native-vision-camera::VisionCamera)
