import { createFileRoute } from "@tanstack/react-router";
import { TaskWindow } from "../a2a/TaskWindow";

export const Route = createFileRoute("/_chat/a2a")({ component: TaskWindow });
