interface ImportMeta {
  glob(
    pattern: string,
    options: {
      readonly query?: string;
      readonly import?: string;
      readonly eager?: boolean;
    },
  ): Record<string, () => Promise<unknown>>;
}
