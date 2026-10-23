import { create } from 'zustand';

type ChromeState = {
  /** True while a sheet inside a shop tab is open, so the floating tab bar must not cover it. */
  tabBarHidden: boolean;
  setTabBarHidden: (hidden: boolean) => void;
};

export const initialChrome = { tabBarHidden: false };

export const useChromeStore = create<ChromeState>()((set) => ({
  ...initialChrome,
  setTabBarHidden: (tabBarHidden) => set({ tabBarHidden }),
}));
