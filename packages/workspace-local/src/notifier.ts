import { runCommand, type Run } from "./local-workspace.js";
import type { Channel } from "@shepherd/core";

/** A notification as worded by the front end. */
export interface Message {
  title: string;
  body: string;
}

const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

type Command = [string, string[], Record<string, string>?];

function osCommand(platform: NodeJS.Platform, { title, body }: Message): Command {
  if (platform === "darwin") {
    return ["osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]];
  }
  if (platform === "win32") {
    // The text goes in through the environment, never into the script: PowerShell
    // ends a string at typographic quotes too, so escaping ' is not enough.
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$text = $xml.GetElementsByTagName('text')",
      "$text.Item(0).AppendChild($xml.CreateTextNode($env:SHEPHERD_TITLE)) | Out-Null",
      "$text.Item(1).AppendChild($xml.CreateTextNode($env:SHEPHERD_BODY)) | Out-Null",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('shepherd').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
    ].join("; ");
    return ["powershell", ["-NoProfile", "-Command", script], { SHEPHERD_TITLE: title, SHEPHERD_BODY: body }];
  }
  return ["notify-send", [title, body]];
}

/** Local notifications through herdr or the operating system. */
export function makeNotifier(platform: NodeJS.Platform = process.platform, run: Run = runCommand): (channel: Channel, message: Message) => Promise<void> {
  return async (channel, message) => {
    const [cmd, args, env] =
      channel === "herdr"
        ? (["herdr", ["notification", "show", message.title, "--body", message.body, "--sound", "request"]] as Command)
        : osCommand(platform, message);
    const r = await run(cmd, args, env);
    if (r.code !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim()}`);
  };
}
