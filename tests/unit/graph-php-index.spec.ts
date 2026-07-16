import { describe, expect, it } from "vitest";
import { buildPhpIndex, parsePhpDeclarations, phpReferencedTypeNames } from "../../src/graph/php-index.js";
import { buildBasenameIndex, resolveSpecifier, resolveSpecifierTargets } from "../../src/graph/resolve-imports.js";
import { extractImports } from "../../src/graph/import-scan.js";

describe("parsePhpDeclarations", () => {
  it("associates class/interface/trait/enum declarations with the file's namespace", () => {
    const content = `<?php
namespace App\\Models;

class User {}
interface Authenticatable {}
trait HasFactory {}
enum Status { case Active; }
`;
    const decl = parsePhpDeclarations(content);
    expect(decl.namespaces).toEqual(["App\\Models"]);
    expect(decl.types.sort()).toEqual([
      "App\\Models\\Authenticatable",
      "App\\Models\\HasFactory",
      "App\\Models\\Status",
      "App\\Models\\User",
    ]);
  });

  it("ignores types outside any namespace declaration", () => {
    expect(parsePhpDeclarations("class Loose {}\n").types).toEqual([]);
  });
});

describe("PHP import scanning", () => {
  it("extracts a namespace declaration, plain use, aliased use, and group use", () => {
    const content = `<?php
namespace App\\Http\\Controllers;

use App\\Models\\User;
use App\\Models\\Order as OrderModel;
use App\\Services\\{Billing, Mailer as MailService};

class UserController {}
`;
    const specs = extractImports("app/Http/Controllers/UserController.php", content);
    expect(specs).toContain("php-ns:App\\Http\\Controllers");
    expect(specs).toContain("php-type:App\\Models\\User");
    expect(specs).toContain("php-type:App\\Models\\Order");
    expect(specs).toContain("php-type:App\\Services\\Billing");
    expect(specs).toContain("php-type:App\\Services\\Mailer");
  });

  it("still extracts literal require/include specs alongside PSR-4 use", () => {
    const specs = extractImports("bootstrap.php", `<?php require 'vendor/autoload.php';\n`);
    expect(specs).toContain("vendor/autoload.php");
  });
});

describe("PHP resolution end-to-end", () => {
  const FILES = new Set([
    "app/Models/User.php",
    "app/Models/Order.php",
    "app/Http/Controllers/UserController.php",
    "app/Http/Controllers/OrderController.php",
  ]);
  const userModel = `<?php
namespace App\\Models;

class User {}
`;
  const orderModel = `<?php
namespace App\\Models;

class Order {}
`;
  const controller = `<?php
namespace App\\Http\\Controllers;

use App\\Models\\User;

class UserController {
    public function show(User $user) {}
}
`;

  function buildCtx(sources: Array<{ path: string; content: string }>) {
    return {
      byBasename: buildBasenameIndex(FILES),
      php: buildPhpIndex(sources),
    };
  }

  it("resolves a plain `use` to the declaring file", () => {
    const ctx = buildCtx([
      { path: "app/Models/User.php", content: userModel },
      { path: "app/Models/Order.php", content: orderModel },
    ]);
    expect(resolveSpecifier("app/Http/Controllers/UserController.php", "php-type:App\\Models\\User", FILES, ctx))
      .toBe("app/Models/User.php");
  });

  it("resolves the file's own namespace declaration for same-namespace usage", () => {
    /* App\Http\Controllers has two files; UserController's own namespace spec
       should resolve to (at least) OrderController too, mirroring C#'s
       same-namespace-needs-no-using behavior. */
    const ctx = buildCtx([
      { path: "app/Http/Controllers/UserController.php", content: controller },
      { path: "app/Http/Controllers/OrderController.php", content: "<?php\nnamespace App\\Http\\Controllers;\n\nclass OrderController {}\n" },
    ]);
    const hits = resolveSpecifierTargets("app/Http/Controllers/UserController.php", "php-ns:App\\Http\\Controllers", FILES, ctx);
    expect(hits).toContain("app/Http/Controllers/OrderController.php");
  });

  it("gates a large namespace to only files declaring a referenced type", () => {
    const sources = [
      { path: "app/Models/User.php", content: userModel },
      { path: "app/Models/Order.php", content: orderModel },
    ];
    /* Pad the namespace past the small-namespace threshold with unrelated types. */
    for (let i = 0; i < 6; i += 1) {
      sources.push({ path: `app/Models/Extra${i}.php`, content: `<?php\nnamespace App\\Models;\n\nclass Extra${i} {}\n` });
    }
    const allFiles = new Set([...FILES, ...sources.map((s) => s.path)]);
    const ctx = { byBasename: buildBasenameIndex(allFiles), php: buildPhpIndex(sources) };
    const referenced = phpReferencedTypeNames(controller);
    const hits = resolveSpecifierTargets("app/Http/Controllers/UserController.php", "php-ns:App\\Models", allFiles, ctx, undefined, referenced);
    expect(hits).toContain("app/Models/User.php");
    expect(hits).not.toContain("app/Models/Extra0.php");
  });
});
