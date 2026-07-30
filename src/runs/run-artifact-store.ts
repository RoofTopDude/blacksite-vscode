import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ArtifactContent = string | Uint8Array;

export interface ContentAddressedArtifact {
  id: string;
  sha256: string;
  byteLength: number;
  path: string;
  created: boolean;
}

/**
 * Filesystem-only content-addressed blob store.
 *
 * Metadata describing how a run uses a blob lives in RunStore. Keeping blob
 * identity independent of media type allows screenshots and other captures with
 * identical bytes to deduplicate across runs.
 */
export class RunArtifactStore {
  readonly rootPath: string;

  constructor(workspaceRoot: string) {
    this.rootPath = path.join(path.resolve(workspaceRoot), ".blacksite", "runs", "artifacts", "sha256");
  }

  ensureInitialized(): this {
    fs.mkdirSync(this.rootPath, { recursive: true });
    return this;
  }

  put(content: ArtifactContent): ContentAddressedArtifact {
    this.ensureInitialized();
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const destination = this.path(sha256);

    if (fs.existsSync(destination)) {
      return {
        id: sha256,
        sha256,
        byteLength: fs.statSync(destination).size,
        path: destination,
        created: false,
      };
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${sha256}.${randomUUID()}.tmp`);

    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx" });
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        // Another writer may have won the content-addressed race.
        if (!fs.existsSync(destination)) throw error;
        fs.rmSync(temporary, { force: true });
      }
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Best-effort cleanup; the blob write error remains the useful failure.
      }
      throw error;
    }

    return {
      id: sha256,
      sha256,
      byteLength: bytes.byteLength,
      path: destination,
      created: true,
    };
  }

  get(id: string): ContentAddressedArtifact | undefined {
    const sha256 = normalizeArtifactId(id);
    const artifactPath = this.path(sha256);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(artifactPath);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    return {
      id: sha256,
      sha256,
      byteLength: stat.size,
      path: artifactPath,
      created: false,
    };
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  read(id: string): Buffer {
    return fs.readFileSync(this.path(id));
  }

  path(id: string): string {
    const sha256 = normalizeArtifactId(id);
    return path.join(this.rootPath, sha256.slice(0, 2), sha256);
  }

  /**
   * Removes one exact blob. RunStore calls this only after proving that no retained
   * run references the artifact.
   */
  remove(id: string): boolean {
    const artifactPath = this.path(id);
    try {
      fs.rmSync(artifactPath);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }
}

function normalizeArtifactId(id: string): string {
  const normalized = id.startsWith("sha256:") ? id.slice("sha256:".length) : id;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error(`Invalid SHA-256 artifact id: ${id}`);
  }
  return normalized.toLowerCase();
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
