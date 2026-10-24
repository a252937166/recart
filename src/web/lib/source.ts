/** A link to a file or folder in the public repository. Paths start at the repository root, which is this project's root. */
export const sourceUrl = (repo: string, path: string) => `${repo.replace(/\/$/, "")}/tree/main/${path}`;
