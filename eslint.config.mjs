// The community directory's automated review lints the plugin with
// eslint-plugin-obsidianmd's recommended config. `npm run lint` runs the same
// config over what the review reads, so CI catches what review would fail.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    // wasm-pack's generated glue; its typings are linted, as the review does.
    { ignores: ["vendor/**/*.js"] },
    ...obsidianmd.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["eslint.config.mjs"],
                },
            },
        },
    },
]);
