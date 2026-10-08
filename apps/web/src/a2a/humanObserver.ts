export interface HumanObserverView {
  state: "missing" | "starting" | "healthy" | "failed" | "stopped";
  updatedAt?: string;
  failureReason?: string;
}

/** View of T-037's optional observer status. Missing data never means healthy. */
export function humanObserverView(result: unknown): HumanObserverView {
  if (!result || typeof result !== "object") throw new Error("人工输入记录器响应格式错误");
  if (!("human_input_observer" in result) || result.human_input_observer === undefined)
    return { state: "missing" };
  const value = result.human_input_observer;
  if (
    !value ||
    typeof value !== "object" ||
    !("state" in value) ||
    !("updated_at" in value) ||
    typeof value.updated_at !== "string"
  )
    throw new Error("人工输入记录器状态格式错误");
  const state = value.state;
  if (state !== "starting" && state !== "healthy" && state !== "failed" && state !== "stopped")
    throw new Error("人工输入记录器状态不可识别");
  if (state === "failed") {
    if (
      !("failure" in value) ||
      !value.failure ||
      typeof value.failure !== "object" ||
      !("reason" in value.failure) ||
      typeof value.failure.reason !== "string"
    )
      throw new Error("人工输入记录器故障缺少原因");
    return { state, updatedAt: value.updated_at, failureReason: value.failure.reason };
  }
  return { state, updatedAt: value.updated_at };
}
