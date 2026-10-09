import { create } from "zustand";
import * as Schema from "effect/Schema";
import {
  getLocalStorageItem,
  setLocalStorageItem,
  removeLocalStorageItem,
} from "../hooks/useLocalStorage";

const prefix = "a2a-issue-reply:";
let loaded = false;
interface DraftState {
  drafts: Record<string, string>;
  error: string | null;
  load: () => void;
  change: (issue: string, text: string) => void;
  clear: (issues: ReadonlyArray<string>) => void;
}

export const useIssueDrafts = create<DraftState>((set, get) => {
  return {
    drafts: {},
    error: null,
    load: () => {
      if (loaded) return;
      loaded = true;
      try {
        const drafts: Record<string, string> = {};
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key?.startsWith(prefix))
            drafts[key.slice(prefix.length)] = getLocalStorageItem(key, Schema.String) ?? "";
        }
        set({ drafts, error: null });
        // Each issue owns one storage key; another window cannot overwrite
        // unrelated drafts when it sends or edits a different question.
        window.addEventListener("storage", (event) => {
          if (event.storageArea !== null && event.storageArea !== localStorage) return;
          if (event.key === null) {
            set({ drafts: {} });
            return;
          }
          if (!event.key?.startsWith(prefix)) return;
          const drafts = { ...get().drafts };
          const issue = event.key.slice(prefix.length);
          try {
            const value = getLocalStorageItem(event.key, Schema.String);
            if (value === null) delete drafts[issue];
            else drafts[issue] = value;
            set({ drafts, error: null });
          } catch (error) {
            set({ error: `草稿未能读取：${String(error)}` });
          }
        });
      } catch (error) {
        set({ error: `草稿未能读取：${String(error)}` });
      }
    },
    change: (issue, text) => {
      const drafts = { ...get().drafts, [issue]: text };
      try {
        setLocalStorageItem(prefix + issue, text, Schema.String);
        set({ drafts, error: null });
      } catch (error) {
        set({ drafts, error: `草稿未能保存到本机：${String(error)}` });
      }
    },
    clear: (issues) => {
      const drafts = { ...get().drafts };
      let failure: string | null = null;
      for (const issue of issues) {
        try {
          removeLocalStorageItem(prefix + issue);
          delete drafts[issue];
        } catch (error) {
          failure = `已发送，但本机草稿未能清除：${String(error)}`;
        }
      }
      set({ drafts, error: failure });
    },
  };
});
