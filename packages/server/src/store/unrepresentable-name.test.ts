/**
 * `EINVAL` attribution — which ids the store may call absent (#252).
 *
 * The sibling assertions in `tools/kit-id-gate.test.ts` cover `ENAMETOOLONG`
 * against the real filesystem, because an overlong component is a fault every
 * POSIX platform will actually raise. `EINVAL` is not like that: it is Win32's
 * answer for a character IT reserves, and on the platforms this suite runs on
 * those same characters are ordinary. Provoking it is therefore impossible
 * here, and a test that skipped itself off Windows would assert nothing on the
 * machine that runs it.
 *
 * So the fault is injected at the only seam that matters — `readFile` — and the
 * question asked is the one the predicate exists to answer: given this error and
 * this id, is the id ATTRIBUTABLE, or is this an operational fault?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));

const { readFile } = await import("node:fs/promises");
const { LocalFsKitStore } = await import("./local.js");
const { NotFoundError } = await import("./interface.js");
const { isSafeKitId } = await import("./kit-files.js");

/** An `EINVAL` shaped the way libuv shapes it, path and all. */
const einval = (id: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EINVAL: invalid argument, open '/srv/kits/${id}/.kit.json'`), {
    code: "EINVAL",
    syscall: "open",
    path: `/srv/kits/${id}/.kit.json`,
  });

describe("local store — an EINVAL is absence only when the id explains it", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it("🔒 attributes a Win32-reserved character to the id, not to the server", async () => {
    // The established half of the rule, kept as the anti-vacuity control: if
    // this ever stopped answering absence, the two cases below would be
    // measuring a broken route rather than a narrow character set.
    vi.mocked(readFile).mockRejectedValue(einval('a"b'));
    await expect(new LocalFsKitStore("/srv/kits").getKit('a"b')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("🔒 attributes a control character to the id, exactly as Win32 does", async () => {
    // Win32 forbids U+0001–U+001F in a path component just as flatly as it
    // forbids `<>:"|?*`, and `isSafeKitId` deliberately lets them through: they
    // are legal POSIX directory names, and refusing them at the gate would make
    // a legitimately-named kit unusable everywhere to protect one platform.
    //
    // That is the right call for the GATE, and it is precisely why the
    // CLASSIFIER has to know about them. An id the shared gate admits and Win32
    // cannot represent still names no kit — so reporting it as an operational
    // fault tells the caller their server is broken when the truth is that
    // their id can never exist. That is #252's fault-as-absence inversion,
    // running in the unsafe direction, inside the predicate added to remove it.
    const id = "a\u0001b";
    expect(isSafeKitId(id), "the shared gate admits it, so the store must answer for it").toBe(
      true,
    );

    vi.mocked(readFile).mockRejectedValue(einval(id));
    await expect(new LocalFsKitStore("/srv/kits").getKit(id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("🔒 covers the whole C0 range Win32 reserves, and stops at U+0020", async () => {
    const store = new LocalFsKitStore("/srv/kits");
    for (let code = 0x01; code <= 0x1f; code += 1) {
      const id = `a${String.fromCharCode(code)}b`;
      vi.mocked(readFile).mockRejectedValue(einval(id));
      await expect(
        store.getKit(id),
        `U+${code.toString(16).padStart(4, "0").toUpperCase()} is reserved on Win32`,
      ).rejects.toBeInstanceOf(NotFoundError);
    }

    // The boundary, stated as behaviour rather than as a regex reading. A space
    // is representable everywhere, so an `EINVAL` carrying one is unexplained by
    // the id and must stay a fault.
    vi.mocked(readFile).mockRejectedValue(einval("a b"));
    await expect(store.getKit("a b")).rejects.not.toBeInstanceOf(NotFoundError);
  });

  it("🔒 an EINVAL the id cannot explain is still an operational fault", async () => {
    // The containment half. Widening the character set must not slide into
    // "EINVAL means absent": a plain slug raising EINVAL is a genuine argument
    // fault, and answering `kitNotFound` for it hides a defect no caller can
    // diagnose — the original #252 report, verbatim.
    vi.mocked(readFile).mockRejectedValue(einval("plain-kit"));

    const error = await new LocalFsKitStore("/srv/kits").getKit("plain-kit").then(
      () => undefined,
      (thrown: unknown) => thrown as NodeJS.ErrnoException,
    );

    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error?.code).toBe("EINVAL");
    // …and it still does not disclose the server's layout.
    expect(error?.message).not.toContain("/srv/kits");
  });

  it("🔒 NUL never reaches this predicate, because the gate already refuses it", async () => {
    // U+0000 is the one control character `isSafeKitId` rejects outright, so it
    // is not in the classifier's remit and its absence from the reserved set is
    // not a gap. Stated here so a later reader does not "fix" it.
    expect(isSafeKitId("a\u0000b")).toBe(false);
  });
});
