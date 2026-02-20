import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/qc-lidar-explorer-v3/",
  plugins: [react()],
});

