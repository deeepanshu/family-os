# systemd

Use this directory for Raspberry Pi service files if the backend is deployed without Docker.

Expected service behavior:

- Start the Bun API on boot.
- Restart on failure.
- Load environment variables from a local env file outside git.
