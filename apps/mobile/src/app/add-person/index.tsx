import { SignInScreen } from '@/features/auth/SignInScreen';

/** Sign-in for another person while this phone stays signed in. */
export default function AddPersonRoute() {
  return <SignInScreen flow="add" />;
}
