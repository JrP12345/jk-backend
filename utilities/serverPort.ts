export function getServerPort(value = process.env.PORT): number {
  if (value === undefined || value.trim() === "") return 5000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}
