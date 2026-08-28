/**
 * Minimal environment inherited by agent-launched processes.
 *
 * Provider tokens, cloud credentials, CI secrets, and extension-internal values must not become
 * ambient authority for workspace code. Keep this list deliberately small and shared by shell,
 * long-running process, git, and test execution paths so a convenience runner cannot silently
 * regain the full extension-host environment.
 */
export function buildSanitizedProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = process.platform === "win32"
    ? ["APPDATA", "ComSpec", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT",
       "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PYTHONIOENCODING",
       "SystemRoot", "TEMP", "TMP", "USERPROFILE"]
    : ["HOME", "LANG", "LC_ALL", "PATH", "PYTHONIOENCODING", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  env.PYTHONIOENCODING = "utf-8";
  if (process.platform === "win32") {
    // cmd.exe probes the current directory before PATH. resolveCommandForSpawn already resolves
    // bare names from trusted PATH entries, but when that lookup misses the shell would fall back
    // to a workspace-local `<name>.cmd` and silently run it under the identity the user approved.
    // Opt the fallback out entirely; an intentional workspace script is still reachable as `./x`.
    env.NoDefaultCurrentDirectoryInExePath = "1";
  }
  return env;
}
