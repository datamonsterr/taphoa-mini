import { useSignIn, useSignUp } from '@clerk/expo';
import { useRouter } from 'expo-router';
import { create } from 'zustand';

import { useEmailFlow } from './emailFlow';

/** `add` runs the same screens as sign-in for someone joining a phone that is already signed in. */
export type AuthFlow = 'add' | undefined;

/** Where each step of a flow lives. `callback` is the path Google returns to (it must render while signed in). */
export const flowPaths = (flow: AuthFlow) =>
  flow === 'add'
    ? ({
        form: '/add-person',
        code: '/add-person/verify-code',
        callback: 'add-person',
      } as const)
    : ({
        form: '/sign-in',
        code: '/verify-code',
        callback: 'sign-in',
      } as const);

/**
 * The Clerk session that was active when "add a person" began. A new session replaces it as soon
 * as the code is finalized, and the screen tree is rebuilt around the new person, so the add
 * routes compare against this instead of navigating while that happens.
 * `undefined`: not started; `null`: started while nobody was signed in.
 */
export const useAddPerson = create<{
  from: string | null | undefined;
  begin: (sessionId: string | null) => void;
  end: () => void;
}>((set) => ({
  from: undefined,
  begin: (from) => set({ from }),
  end: () => set({ from: undefined }),
}));

/** Drops the half-finished attempt and returns to the account tab. Nobody is signed out. */
export function useCancelAddPerson() {
  const router = useRouter();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  return async () => {
    await signIn.reset();
    await signUp.reset();
    useEmailFlow.getState().reset();
    useAddPerson.getState().end();
    router.dismissTo('/account');
  };
}
