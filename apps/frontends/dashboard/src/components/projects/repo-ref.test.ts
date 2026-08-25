import { describe, expect, it } from "vitest"
import { nextFreeName, parseRepoRef } from "./repo-ref"

/*
  The store is browsable, not a boundary. Somebody starting a project should be able to copy any
  repository on GitHub — and the thing they have when they decide to is almost always the browser
  URL, not the `owner/repo` short form. A field that accepts only the short form rejects exactly
  what is in their clipboard, and does it with "that does not look like a repository", which reads
  as the repository being wrong rather than the format.
*/
describe("parseRepoRef", () => {
  it.each([
    ["Andrew-Chen-Wang/reddit-clone"],
    ["https://github.com/Andrew-Chen-Wang/reddit-clone"],
    ["http://github.com/Andrew-Chen-Wang/reddit-clone"],
    ["https://www.github.com/Andrew-Chen-Wang/reddit-clone"],
    ["https://github.com/Andrew-Chen-Wang/reddit-clone/"],
    ["https://github.com/Andrew-Chen-Wang/reddit-clone.git"],
    ["git@github.com:Andrew-Chen-Wang/reddit-clone.git"],
    ["  Andrew-Chen-Wang/reddit-clone  "],
  ])("reads %s", (input) => {
    expect(parseRepoRef(input)).toEqual({ owner: "Andrew-Chen-Wang", repo: "reddit-clone" })
  })

  it("keeps dots in a repository name that are not a .git suffix", () => {
    expect(parseRepoRef("owner/my.config.repo")).toEqual({ owner: "owner", repo: "my.config.repo" })
  })

  /*
    A deep link is not a repository reference. `.../reddit-clone/tree/main` names a branch, and
    accepting it by taking the first two segments would silently drop what the person pointed at —
    the copy would come from somewhere they did not choose, which is worse than being asked again.
  */
  it.each([
    ["https://github.com/Andrew-Chen-Wang/reddit-clone/tree/main"],
    ["Andrew-Chen-Wang"],
    ["Andrew-Chen-Wang/"],
    ["/reddit-clone"],
    [""],
    ["   "],
    ["owner/repo/extra"],
    ["own er/repo"],
    ["owner/re po"],
  ])("refuses %s", (input) => {
    expect(parseRepoRef(input)).toBeNull()
  })
})

/*
  Copying a repository twice is a normal thing to do, and so is having copied it months ago and
  forgotten. `-2` says "the same thing again" in a way an invented name does not.
*/
describe("nextFreeName", () => {
  it("suffixes when the name is taken", () => {
    expect(nextFreeName("reddit-clone", [{ name: "reddit-clone" }])).toBe("reddit-clone-2")
  })

  it("skips past suffixes that are also taken", () => {
    expect(
      nextFreeName("reddit-clone", [
        { name: "reddit-clone" },
        { name: "reddit-clone-2" },
        { name: "reddit-clone-3" },
      ]),
    ).toBe("reddit-clone-4")
  })

  /*
    Counting from the base, not from the suffixed name. Suggesting `-2` twice would otherwise walk
    to `reddit-clone-2-2`, which reads as a mistake because it is one.
  */
  it("counts from the base when the name is already suffixed", () => {
    expect(
      nextFreeName("reddit-clone-2", [{ name: "reddit-clone" }, { name: "reddit-clone-2" }]),
    ).toBe("reddit-clone-3")
  })

  it("matches case-insensitively, as GitHub does", () => {
    expect(nextFreeName("Reddit-Clone", [{ name: "reddit-clone" }])).toBe("Reddit-Clone-2")
  })
})
