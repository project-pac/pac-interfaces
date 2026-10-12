# PAC Explorer

PAC's network, as anyone can verify it, and every detail of your own sessions.

- **Public** (explorer.projectpac.net, `node bin/main.ts explorer --public`): the
  vault's height, TEEs and their attestations, the chain of TEE handovers,
  releases and their measurements, program manifests, profiles, and the
  bulletin. Every signature is checked again here, independently of PAC's
  code: Ed25519 over `"pac/v1/" + domain + "\n" + JCS(value)`.
- **Yours** (`node bin/main.ts explorer`, on 127.0.0.1): everything above, plus
  every session you're in, read through your own `pac`: its turns, PAC's asks
  to you, your results, the files of yours PAC read, and the proof (the code
  that answered, its measurement against the signed descriptor, and the
  attested TEEs that run it). It prints a link that signs your browser in;
  nothing leaves your machine.

Sessions are encrypted to the people in them, so the public explorer has none:
that's PAC's promise, not a gap.

## Run it

```bash
node bin/main.ts explorer             # yours: open the link it prints
node bin/main.ts explorer --public    # the hosted one: PORT (8080), PAC_EXPLORER_DATA (activity samples)
```

Deploy: `explorer/Dockerfile` (Railway: `RAILWAY_DOCKERFILE_PATH=explorer/Dockerfile`, a volume at `/data`).
