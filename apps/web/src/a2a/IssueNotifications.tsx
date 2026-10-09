import { useEffect, useRef } from "react";
import { useAppSettings } from "../appSettings";
import { useAllIssues } from "./useIssues";

export function IssueNotifications() {
  const { issues, ready } = useAllIssues();
  const { settings } = useAppSettings();
  const observed = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const waiting = issues.filter((item) => item.view.state === "等你决定");
    const keys = waiting.map(
      ({ view }) => `${view.issue.id}:${view.disposition?.id ?? view.issue.id}`,
    );
    if (observed.current === null) {
      observed.current = new Set(keys);
      return;
    }
    const fresh = waiting.filter((_item, index) => !observed.current!.has(keys[index]!));
    for (const key of keys) observed.current.add(key);
    if (
      !fresh.length ||
      !settings.enableSystemTaskCompletionNotifications ||
      (document.visibilityState === "visible" && document.hasFocus())
    )
      return;
    const title = `${fresh.length} 个问题等你决定`;
    const body = fresh
      .map(({ view }) => `问题 ${view.issue.number}：${view.issue.title}`)
      .join("\n");
    if (window.desktopBridge) {
      void window.desktopBridge.notifications
        .show({ title, body, silent: true, suppressWhenForeground: true })
        .catch((error) => {
          console.error("问题通知未能发送", error);
        });
    }
  }, [issues, ready, settings.enableSystemTaskCompletionNotifications]);
  return null;
}
