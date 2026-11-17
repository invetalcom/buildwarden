export const formatByteSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  let maximumFractionDigits = 2;
  if (unitIndex === 0 || value >= 100) {
    maximumFractionDigits = 0;
  } else if (value >= 10) {
    maximumFractionDigits = 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${units[unitIndex]}`;
};
