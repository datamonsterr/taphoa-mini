import { Redirect } from 'expo-router';
import VisionDevScreen from '@/features/camera/vision/VisionDevScreen';
import { visionDevEnabled } from '@/features/camera/vision/dev';

export default function VisionRoute() {
  if (!visionDevEnabled()) return <Redirect href="/" />;
  return <VisionDevScreen />;
}
