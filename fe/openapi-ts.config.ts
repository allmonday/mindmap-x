import { defineConfig } from '@hey-api/openapi-ts'

const input =
  process.env.OPENAPI_INPUT ?? 'http://127.0.0.1:8740/openapi.json'

export default defineConfig({
  input,
  output: {
    path: './src/sdk',
  },
})
