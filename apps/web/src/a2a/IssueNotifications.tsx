import type { A2AGateResult } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { useAppSettings } from "../appSettings";
import { toastManager } from "../components/ui/toast";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { requestA2A } from "./api";
import { useAllIssues } from "./useIssues";

const reminderPrefix = "a2a-issue-reminded:";

export function IssueNotifications() {
  const { issues, ready } = useAllIssues();
  const { settings } = useAppSettings();
  const inbox = useQuery({
    queryKey: ["a2a-notification-inbox", "ideation"],
    retry: false,
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
    queryFn: async ({ signal }) => {
      const result = await requestA2A<A2AGateResult>(
        "/api/a2a",
        { command: "inbox_list", role: "ideation" },
        signal,
      );
      if (!result.ok) throw new Error(result.error ?? "提醒读取失败");
      return (result.entries ?? []).filter(({ entry }) => entry.kind === "needs-decision");
    },
  });
  const observedIssues = useRef<Set<string> | null>(null);
  const observedInbox = useRef<Set<string> | null>(null);
  const attempted = useRef(new Set<string>());
  const [foreground, setForeground] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  useEffect(() => {
    const update = () =>
      setForeground(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  useEffect(() => {
    const changes: string[] = [];
    const waiting: { key: string; text: string; controller: boolean }[] = [];
    if (ready) {
      const keys = issues.map(
        ({ view }) =>
          `${view.issue.id}:${view.disposition?.id ?? ""}:${view.answer?.id ?? ""}:${view.state}`,
      );
      if (observedIssues.current !== null) {
        issues.forEach(({ view }, index) => {
          if (!observedIssues.current!.has(keys[index]!))
            changes.push(`问题 ${view.issue.number}：${view.issue.title} · ${view.state}`);
        });
      }
      observedIssues.current ??= new Set();
      keys.forEach((key) => observedIssues.current!.add(key));
      for (const { view } of issues) {
        if (view.state === "等你决定")
          waiting.push({
            key: `${view.issue.id}:${view.disposition?.id ?? view.issue.id}`,
            text: `问题 ${view.issue.number}：${view.issue.title}`,
            controller: false,
          });
      }
    }
    if (inbox.isSuccess) {
      for (const { entry } of inbox.data) {
        const text = entry.title || "主控需要你回复";
        if (observedInbox.current !== null && !observedInbox.current.has(entry.id))
          changes.push(text);
        waiting.push({ key: entry.id, text, controller: true });
      }
      observedInbox.current ??= new Set();
      inbox.data.forEach(({ entry }) => observedInbox.current!.add(entry.id));
    }
    if (changes.length)
      toastManager.add({ type: "info", title: "问题上报有更新", description: changes.join("\n") });
    if (
      !ready ||
      !inbox.isSuccess ||
      !settings.enableSystemTaskCompletionNotifications ||
      foreground ||
      !window.desktopBridge
    )
      return;
    let fresh: typeof waiting;
    try {
      fresh = waiting.filter(
        ({ key }) =>
          !attempted.current.has(key) &&
          getLocalStorageItem(reminderPrefix + key, Schema.Boolean) !== true,
      );
    } catch (error) {
      toastManager.add({ type: "error", title: "提醒记录未能读取", description: String(error) });
      return;
    }
    if (!fresh.length) return;
    const title = fresh.some(({ controller }) => controller)
      ? `${fresh.length} 项需要你回复`
      : `${fresh.length} 个问题等你决定`;
    const timer = window.setTimeout(() => {
      fresh.forEach(({ key }) => attempted.current.add(key));
      void window
        .desktopBridge!.notifications.show({
          title,
          body: fresh.map(({ text }) => text).join("\n"),
          silent: true,
          suppressWhenForeground: true,
        })
        .then((accepted) => {
          if (!accepted) return;
          fresh.forEach(({ key }) => {
            setLocalStorageItem(reminderPrefix + key, true, Schema.Boolean);
          });
        })
        .catch((error) => {
          console.error("问题提醒未能发送或保存", error);
          toastManager.add({
            type: "error",
            title: "问题提醒未能发送或保存",
            description: String(error),
          });
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [
    issues,
    ready,
    inbox.data,
    inbox.isSuccess,
    foreground,
    settings.enableSystemTaskCompletionNotifications,
  ]);
  return null;
}
