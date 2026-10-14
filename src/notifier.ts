import { runCommand, type Run } from "./local-workspace.js";
import type { Message, Notify } from "./notify.js";

const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function osCommand(platform: NodeJS.Platform, { title, body }: Message): [string, string[]] {
  if (platform === "darwin") {
    return ["osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]];
  }
  if (platform === "win32") {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$text = $xml.GetElementsByTagName('text')",
      `$text.Item(0).AppendChild($xml.CreateTextNode(${psString(title)})) | Out-Null`,
      `$text.Item(1).AppendChild($xml.CreateTextNode(${psString(body)})) | Out-Null`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('psdd').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
    ].join("; ");
    return ["powershell", ["-NoProfile", "-Command", script]];
  }
  return ["notify-send", [title, body]];
}

/** Local notifications through herdr or the operating system. */
export function makeNotifier(platform: NodeJS.Platform = process.platform, run: Run = runCommand): Notify {
  return async (channel, message) => {
    const [cmd, args] =
      channel === "herdr"
        ? (["herdr", ["notification", "show", message.title, "--body", message.body, "--sound", "request"]] as [string, string[]])
        : osCommand(platform, message);
    const r = await run(cmd, args);
    if (r.code !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim()}`);
  };
}
