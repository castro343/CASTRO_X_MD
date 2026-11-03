export function createCommandRegistry(commandModules = []) {
  const commands = new Map();
  const aliases = new Map();

  for (const command of commandModules.flat()) {
    if (!command || typeof command.name !== "string" || typeof command.execute !== "function") {
      throw new TypeError("Each command must have a name and execute function");
    }
    const name = command.name.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new TypeError(`Invalid command name: ${command.name}`);
    if (commands.has(name) || aliases.has(name)) throw new Error(`Duplicate command name: ${name}`);
    const normalized = { category: "General", description: "No description provided.", ...command, name };
    commands.set(name, normalized);

    for (const aliasValue of command.aliases || []) {
      const alias = String(aliasValue).trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(alias)) throw new TypeError(`Invalid command alias: ${alias}`);
      if (commands.has(alias) || aliases.has(alias)) throw new Error(`Duplicate command alias: ${alias}`);
      aliases.set(alias, name);
    }
  }

  return {
    get(name) {
      const key = String(name || "").toLowerCase();
      return commands.get(aliases.get(key) || key);
    },
    list() {
      return [...commands.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    }
  };
}
