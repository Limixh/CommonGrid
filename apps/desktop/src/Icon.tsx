export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    chip: "M7 7h10v10H7z M9 1v6m6-6v6M9 17v6m6-6v6M1 9h6m-6 6h6m10-6h6m-6 6h6",
    settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
    refresh: "M20 7A9 9 0 1 0 21 14M20 2v5h-5",
    lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
    code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16",
    check: "m5 12 4 4L19 6",
    file: "M5 2h9l5 5v15H5zM14 2v5h5",
    clock: "M12 8v5l3 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20",
    globe:
      "M2 12h20M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 2c-6 6-6 14 0 20 6-6 6-14 0-20",
    user: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21v-3a8 8 0 0 1 16 0v3",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.grid} />
    </svg>
  );
}
