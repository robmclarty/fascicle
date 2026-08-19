<!-- source: https://github.com/evanw/esbuild/blob/main/CHANGELOG.md 

Note on pattern: main CHANGELOG is for current year, with links to past years archived as "CHANGELOG-2025.md" beside it.
-->

# Changelog

## Unreleased

* Allow `es2026` as a target in `tsconfig.json`

    TypeScript is [adding `es2026`](https://github.com/microsoft/TypeScript/issues/63704) as a compilation target, so esbuild now supports this in the `target` field of `tsconfig.json` files, such as in the following configuration file:

    ```json
    {
      "compilerOptions": {
        "target": "ES2026"
      }
    }
    ```

    As a reminder, the only thing that esbuild uses this field for is determining whether or not to use legacy TypeScript behavior for class fields. You can read more in [the documentation](https://esbuild.github.io/content-types/#tsconfig-json).

* Stop publishing to https://deno.land/x/esbuild

    Deno has made the https://deno.land/x package registry read-only, so new versions of esbuild can no longer be published to https://deno.land/x/esbuild. The last published version was [v0.28.1](https://deno.land/x/esbuild@v0.28.1). I have removed the parts of esbuild that publish a Deno-specific package. Instead you can install `npm:esbuild` to use esbuild in Deno (this wasn't the case when esbuild's Deno-specific package was first published).

* Emit an error when code splitting chunks would be merged ([#4411](https://github.com/evanw/esbuild/issues/4411))

    It's possible to configure esbuild such that separate output files end up with the same output path. For example, you could name all code splitting chunks `chunk` via the `chunkNames` setting, which might generate multiple output files with the same path `chunk.js`. This does not happen by default since by default the chunk names include a hash to make sure they're unique (e.g. named something like `chunk-GX7G2SBE.js` instead).

    Previously esbuild allowed output files to be merged if both the file path and content were the same. This behavior was intended for assets (e.g. images) but is not appropriate for code, as code modules may still have their own internal state that needs to stay separate. This configuration is no longer allowed starting with this release. Doing this is now a build error. If your code structure generates conflicting chunk names, then you should make sure the chunk names include a placeholder for the hash.

## 0.28.2

* Fix tree shaking bug due to TypeScript import alias ([#4507](https://github.com/evanw/esbuild/issues/4507))

    This release fixes a bug that could cause esbuild to incorrectly tree-shake imports that are used in a TypeScript type alias under certain circumstances. Affected code uses a TypeScript-specific `import` assignment and looks something like this:

    ```ts
    import Base from './dep.js';
    import Alias = Base.SomeType;
    ```

* Fix CSS minification bug involving `&` ([#4497](https://github.com/evanw/esbuild/issues/4497))

    This release fixes a bug where esbuild's CSS minifier incorrectly removed a `&` when it was unsafe to do so. Here is an example:

    ```css
    /* Original code */
    .a .b {
      & .b:not(& .c) {
        color: red;
      }
    }

    /* Old output (with --minify) */
    .a .b{.b:not(& .c){color:red}}

    /* New output (with --minify) */
    .a .b{& .b:not(& .c){color:red}}
    ```

    This should match `<span class="a"><span class="b"><span class="b">yes</span></span></span>` but not `<span class="a"><span class="b">no</span></span>`. The old output incorrectly matched both.

* Avoid overwriting input files without `--allow-overwrite` ([#4484](https://github.com/evanw/esbuild/issues/4484))

    For example: `esbuild input.js --outfile=input.js` tells esbuild to overwrite `input.js` with the output of running esbuild on it. This was supposed to already be prevented by default, but it accidentally regressed in version 0.17.0 and apparently didn't have any test coverage. The error message was being printed but the input file was still being overwritten. Oops.

    This release puts the original behavior back. With this release, esbuild should now actually avoid overwriting input files unless `--allow-overwrite` is explicitly present. This is done by not writing out any files when a build error is encountered.

* Fix incorrect code generated when using top-level await ([#4498](https://github.com/evanw/esbuild/issues/4498))

    Previously esbuild could generate code containing a syntax error in complex scenarios involving top-level await used in a dependency cycle. The problem was a missing `async` on one or more module wrapper closures. With this release, esbuild now uses a fixed-point iteration algorithm to correctly annotate all dependencies in the cycle as needing an `async` module wrapper.

* Fix a minification bug with lowered logical assignment operators ([#4508](https://github.com/evanw/esbuild/issues/4508))

    This release fixes a bug that could cause esbuild to generate incorrect code for logical assignment operators when lowering them to an older target environment. Specifically the lowering process requires duplicating the left-hand side, but esbuild incorrectly failed to count the duplicate as a new usage when the left-hand side is an identifier. That then caused the minifier to believe that the left-hand side was only used once and could attempt to incorrectly inline an initializer into the first usage. This bug has now been fixed:

    ```js
    // Original code
    function foo() {
      let x
      bar(x ||= {})
    }

    // Old output (with --minify-syntax --target=es6)
    function foo() {
      bar(void 0 || (x = {}));
    }

    // New output (with --minify-syntax --target=es6)
    function foo() {
      let x;
      bar(x || (x = {}));
    }
    ```

* Fix a potential deadlock when the JavaScript API is used incorrectly ([#4503](https://github.com/evanw/esbuild/issues/4503), [#4506](https://github.com/evanw/esbuild/pull/4506))

    The JavaScript API runs the native esbuild executable as a long-lived child process and communicates with it over stdin/stdout/stderr. Each API request is asynchronous and the executable stays open as long as it has work to do, which is as long as either stdin is still open (meaning there may be more API requests) or there are currently requests being processed.

    Previously esbuild's tracking of outstanding API requests missed decrementing a reference count in an edge case where esbuild's JavaScript API was used incorrectly and the API request returned an error. This could in some cases cause esbuild's native executable to exit with an error message about a deadlock. This release fixes the reference counting bug.

    This fix was submitted by [@ZuBB](https://github.com/ZuBB).

* Handle target collisions ([#4509](https://github.com/evanw/esbuild/issues/4509))

    It's possible to specify the same target engine multiple times, such as with `--target=chrome1,chrome99`. This edge case wasn't anticipated and previously took the last version for the duplicated target engine instead of the minimum version (so `chrome99` in this case instead of `chrome1`). With this release, esbuild will now pick the minimum version between all duplicated target engines.

* Force `.mp3` files to use the `audio/mpeg` MIME type ([#4485](https://github.com/evanw/esbuild/issues/4485))

    MIME type detection for esbuild's data URLs uses Go's built-in MIME type detection, which is based on the [MIME sniffing standard](https://mimesniff.spec.whatwg.org/). This works correctly for MP3 files that start with the byte sequence `ID3`, which is commonly the case. However, it's possible to construct valid MP3 files that do not start with `ID3`, and that perhaps Go's built-in MIME type detection doesn't implement the "Signature for MP3 without ID3" part of the algorithm. This results in some `.mp3` files incorrectly using the `application/octet-stream` MIME type instead of `audio/mpeg`. With this release, esbuild will now always use the `audio/mpeg` MIME type for files ending in `.mp3`.

* Add a new TypeScript syntax warning

    TypeScript 7 turned some previously-valid TypeScript syntax into a syntax error because it was confusing. TypeScript 6 accepts `1 + 2 as number * 3` as valid syntax but confusingly converts it to `(1 + 2) * 3` instead of the more intuitive conversion to `1 + (2 * 3)`. This syntax is now an error in TypeScript 7+. With this release, esbuild will now warn about the use of this syntax:

    ```ts
    ▲ [WARNING] Operator "*" should not directly follow a TypeScript type cast after the "+" operator [confusing-typescript-cast]

        example.ts:1:28:
          1 │ console.log(1 + 2 as number * 3)
            ╵                             ^

      This is a syntax error in newer versions of TypeScript because the type cast has unintuitive
      precedence in this case. Surround the inner expression in parentheses to silence this warning:

        example.ts:1:12:
          1 │ console.log(1 + 2 as number * 3)
            │             ~~~~~~~~~~~~~~~
            ╵             (             )
    ```

    See [microsoft/TypeScript#63527](https://github.com/microsoft/TypeScript/issues/63527) for more information.

* Add support for formatting errors for Visual Studio ([#4460](https://github.com/evanw/esbuild/issues/4460))

    Visual Studio has a specific style that it expects log messages to be in for them to show up in the UI when esbuild is run as a custom build step. The current log style that esbuild uses doesn't conform to this specific style.

    With this release, esbuild has a new log style for Visual Studio (and other tools in the MSBuild ecosystem) that can be enabled with `--log-style=visualstudio`. Here is an example log message in this style:

    ```
    $ esbuild example.ts --log-style=visualstudio
    /Users/evan/dev/esbuild/example.ts(1,29): warning ES0010: Operator "*" should not directly follow a TypeScript type cast after the "+" operator
    ```

    This log style is also available via the JS and Go APIs, and can now be used with the existing `formatMessages` API.

* Fix a bug with CSS gamut mapping ([#4488](https://github.com/evanw/esbuild/pull/4488))

    Due to a typo, the fallback colors generated for CSS colors outside of the sRGB gamut weren't correct. This release fixes the generated colors to use the intended algorithm.

    This fix was submitted by [@chatman-media](https://github.com/chatman-media).

## 0.28.1

* Disallow ``\`` in local development server HTTP requests ([GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr))

    This release fixes a security issue where HTTP requests to esbuild's local development server could traverse outside of the serve directory on Windows using a ``\`` backslash character. It happened due to the use of Go's `path.Clean()` function, which only handles Unix-style `/` characters. HTTP requests with paths containing ``\`` are no longer allowed.

    Thanks to [@dellalibera](https://github.com/dellalibera) for reporting this issue.

* Add integrity checks to the Deno API ([GHSA-gv7w-rqvm-qjhr](https://github.com/evanw/esbuild/security/advisories/GHSA-gv7w-rqvm-qjhr))

    The previous release of esbuild added integrity checks to esbuild's npm install script. This release also adds integrity checks to esbuild's Deno install script. Now esbuild's Deno API will also fail with an error if the downloaded esbuild binary contains something other than the expected content.

    Note that esbuild's Deno API installs from `registry.npmjs.org` by default, but allows the `NPM_CONFIG_REGISTRY` environment variable to override this with a custom package registry. This change means that the esbuild executable served by `NPM_CONFIG_REGISTRY` must now match the expected content.

    Thanks to [@sondt99](https://github.com/sondt99) for reporting this issue.

* Avoid inlining `using` and `await using` declarations ([#4482](https://github.com/evanw/esbuild/issues/4482))

    Previously esbuild's minifier sometimes incorrectly inlined `using` and `await using` declarations into subsequent uses of that declaration, which then fails to dispose of the resource correctly. This bug happened because inlining was done for `let` and `const` declarations by avoiding doing it for `var` declarations, which no longer worked when more declaration types were added. Here's an example:

    ```js
    // Original code
    {
      using x = new Resource()
      x.activate()
    }

    // Old output (with --minify)
    new Resource().activate();

    // New output (with --minify)
    {using e=new Resource;e.activate()}
    ```

* Fix module evaluation when an error is thrown ([#4461](https://github.com/evanw/esbuild/issues/4461), [#4467](https://github.com/evanw/esbuild/pull/4467))

    If an error is thrown during module evaluation, esbuild previously didn't preserve the state of the module for subsequent module references. This was observable if `import()` or `require()` is used to import a module multiple times. The thrown error is supposed to be thrown by every call to `import()` or `require()`, not just the first. With this release, esbuild will now throw the same error every time you call `import()` or `require()` on a module that throws during its evaluation.

* Fix some edge cases around the `new` operator ([#4477](https://github.com/evanw/esbuild/issues/4477))

    Previously esbuild incorrectly printed certain edge cases involving complex expressions inside the target of a `new` expression (specifically an optional chain and/or a tagged template literal). The generated code for the `new` target was not correctly wrapped with parentheses, and either contained a syntax error or had different semantics. These edge cases have been fixed so that they now correctly wrap the `new` target in parentheses. Here is an example of some affected code:

    ```js
    // Original code
    new (foo()`bar`)()
    new (foo()?.bar)()

    // Old output
    new foo()`bar`();
    new (foo())?.bar();

    // New output
    new (foo())`bar`();
    new (foo()?.bar)();
    ```

* Fix renaming of nested `var` declarations ([#4471](https://github.com/evanw/esbuild/issues/4471))

    This release fixes a bug where `var` declarations in nested scopes that are hoisted up to module scope were not correctly being renamed during bundling. That could previously lead to name collisions when minification was disabled, which could potentially cause a behavior change. The bug has been fixed so that these hoisted declarations are now considered to be module-level symbols during the name collision avoidance pass.

* Emit `var` instead of `const` for certain TypeScript-only constructs for ES5 ([#4448](https://github.com/evanw/esbuild/issues/4448))

    While esbuild doesn't generally support converting `const` to `var` for ES5 due to nested scoping rules (which is currently a build-time error), esbuild previously incorrectly converted TypeScript-only `import` assignment constructs into a `const` declaration even when targeting ES5. With this release, esbuild will now use `var` for this case instead:

    ```js
    // Original code
    import x = require('y')

    // Old output (with --target=es5)
    const x = require("y");

    // New output (with --target=es5)
    var x = require("y");
    ```


<!--
  Trimmed here; 278 more lines upstream. The releases kept are enough to show the entry shape and how a breaking change reads.
-->