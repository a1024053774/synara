import type {
  A2ACapability,
  A2ARolePermissionSelection,
  A2ARolePermissionSettings,
  A2ARolePermissionView,
  A2ASessionPreset,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "../components/settings/SettingsPanelPrimitives";
import { SettingsSegmentedControl } from "../components/settings/SettingControls";
import { requestA2A } from "./api";

const queryKey = ["a2a", "role-permissions"] as const;
const roleLabels: Record<A2ASessionPreset, string> = {
  executor: "执行主控",
  ideation: "构思主控",
  worker: "worker",
  reviewer: "reviewer",
  monitor: "monitor",
};

function RoleEditor({
  view,
  catalog,
  onSaved,
}: {
  view: A2ARolePermissionView;
  catalog: A2ARolePermissionSettings["catalog"];
  onSaved: (settings: A2ARolePermissionSettings) => void;
}) {
  const [selection, setSelection] = useState<A2ARolePermissionSelection | null>(view.effective);
  const [dirty, setDirty] = useState(false);
  const mutation = useMutation({
    mutationFn: (command: "save" | "reset") =>
      requestA2A<A2ARolePermissionSettings>("/api/a2a/role-permissions", {
        command,
        role: view.role,
        revision: view.revision,
        ...(command === "save" ? { selection } : {}),
      }),
    onSuccess: onSaved,
  });
  const editableTools = catalog
    .filter((row) => selection?.capabilities.includes(row.capability))
    .flatMap((row) => row.tools);
  function changeCapability(capability: A2ACapability, enabled: boolean) {
    if (!selection) return;
    const capabilities = enabled
      ? [...selection.capabilities, capability]
      : selection.capabilities.filter((value) => value !== capability);
    const available = catalog
      .filter((row) => capabilities.includes(row.capability))
      .flatMap((row) => row.tools);
    setSelection({
      capabilities,
      autoApproveTools:
        selection.autoApproveTools === null
          ? null
          : selection.autoApproveTools.filter((name) => available.includes(name)),
    });
    setDirty(true);
  }
  return (
    <div className="space-y-5" data-role={view.role}>
      <p className="text-ui text-muted-foreground">
        {roleLabels[view.role]} · {view.custom === null ? "能力沿用默认" : "能力已自定义"} ·
        新会话（重新签发凭据）后生效。
      </p>
      {view.error ? (
        <p role="alert" className="text-ui text-destructive">
          保存的权限含有无效值，已停止签发凭据。原值保留，请恢复默认。
          <code className="block break-all text-ui-xs">{JSON.stringify(view.custom)}</code>
        </p>
      ) : null}
      {selection ? (
        <>
          <SettingsSection title="能力与工具">
            {catalog.map((row) => (
              <SettingsRow
                key={row.capability}
                title={
                  <span>
                    {row.label}
                    {view.defaults.capabilities.includes(row.capability) ? " · 默认开启" : ""}
                  </span>
                }
                description={row.tools.join("、")}
                control={
                  <Switch
                    aria-label={`${roleLabels[view.role]} ${row.capability}`}
                    checked={selection.capabilities.includes(row.capability)}
                    disabled={mutation.isPending}
                    onCheckedChange={(enabled) => changeCapability(row.capability, enabled)}
                  />
                }
              />
            ))}
          </SettingsSection>
          <SettingsSection title="工具免确认">
            <SettingsRow
              title="自定义免确认"
              description={
                selection.autoApproveTools === null
                  ? "沿用默认：a2a_raise / a2a_submit 依运行模式和已有授权免确认，其它 a2a 工具提示。"
                  : "勾选的工具免确认，其它工具提示。取消能力会同时取消对应工具的免确认。"
              }
              control={
                <Switch
                  aria-label={`${roleLabels[view.role]} 自定义免确认`}
                  checked={selection.autoApproveTools !== null}
                  disabled={mutation.isPending}
                  onCheckedChange={(enabled) => {
                    setSelection({ ...selection, autoApproveTools: enabled ? [] : null });
                    setDirty(true);
                  }}
                />
              }
            />
            {selection.autoApproveTools !== null
              ? editableTools.map((name) => (
                  <SettingsRow
                    key={name}
                    title={name}
                    description="此工具一次放行，不保存供应商的永久授权。"
                    control={
                      <Switch
                        aria-label={`${roleLabels[view.role]} ${name} 免确认`}
                        checked={selection.autoApproveTools!.includes(name)}
                        disabled={mutation.isPending}
                        onCheckedChange={(enabled) => {
                          setSelection({
                            ...selection,
                            autoApproveTools: enabled
                              ? [...selection.autoApproveTools!, name]
                              : selection.autoApproveTools!.filter((value) => value !== name),
                          });
                          setDirty(true);
                        }}
                      />
                    }
                  />
                ))
              : null}
          </SettingsSection>
        </>
      ) : null}
      <p className="text-ui-sm text-muted-foreground">
        目前对 Codex、Claude 会话生效。免确认仍要求有效受管身份和活跃 turn。dismiss
        仅用户可做，主控不能关闭 blocking 问题。
      </p>
      {mutation.error ? (
        <p role="alert" className="text-ui text-destructive">
          {mutation.error.message === "stale_revision"
            ? "另一窗口已保存此角色。重新读取后再修改；本次没有覆盖对方的设置。"
            : mutation.error.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!dirty || !selection || mutation.isPending}
          onClick={() => mutation.mutate("save")}
        >
          保存角色权限
        </Button>
        <Button
          variant="outline"
          disabled={view.custom === null || mutation.isPending}
          onClick={() => mutation.mutate("reset")}
        >
          恢复该角色默认
        </Button>
      </div>
    </div>
  );
}

export function RolePermissionsSettingsPanel({ active }: { active: boolean }) {
  const client = useQueryClient();
  const [role, setRole] = useState<A2ASessionPreset>("executor");
  const query = useQuery({
    queryKey,
    queryFn: () => requestA2A<A2ARolePermissionSettings>("/api/a2a/role-permissions"),
    enabled: active,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (!active) return null;
  if (query.error)
    return (
      <p role="alert" className="text-ui text-destructive">
        {query.error.message}
      </p>
    );
  if (!query.data) return <p className="text-ui text-muted-foreground">正在读取角色权限…</p>;
  const view = query.data.roles.find((value) => value.role === role)!;
  return (
    <div className="space-y-6">
      <SettingsSegmentedControl
        ariaLabel="角色"
        value={role}
        options={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))}
        onValueChange={(value) => setRole(value as A2ASessionPreset)}
      />
      <RoleEditor
        key={`${view.role}:${view.revision}`}
        view={view}
        catalog={query.data.catalog}
        onSaved={(settings) => client.setQueryData(queryKey, settings)}
      />
      <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
        重新读取（舍弃本页未保存选择）
      </Button>
      <SettingsSectionShell title="最近变更">
        {query.data.changes.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">尚无权限变更记录。</p>
        ) : (
          <ol className="space-y-3">
            {query.data.changes.map((change) => (
              <li key={change.id} className="break-words text-ui-sm">
                <p>
                  {change.actor} · {new Date(change.created_at).toLocaleString()} ·{" "}
                  {roleLabels[change.role]}
                </p>
                <p className="text-muted-foreground">{change.text}</p>
              </li>
            ))}
          </ol>
        )}
      </SettingsSectionShell>
    </div>
  );
}
