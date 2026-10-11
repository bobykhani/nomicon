# The agent's GitHub identity

In production the agent acts as a **GitHub App** installed on the organisation, not as a person's token. The App has its own bot account (`<name>[bot]`), its tokens live one hour and are minted from a private key on the server, and the App's permissions are exactly the list below and nothing more. `NOTICES.md` names the bot account; the briefing tells everyone that only that account issues quotes.

## Creating the App (owner, once)

1. Organisation settings, Developer settings, GitHub Apps, **New GitHub App**.
2. **Name:** `nomicon-agent` (names are global; if taken, `nomicon-world-agent`). **Homepage URL:** the canonical repository. Leave callback URLs empty.
3. **Webhook:** untick *Active*. The agent polls; it has no inbound webhook.
4. **Repository permissions:**
   - Contents: Read and write (merges, ledger publishing)
   - Pull requests: Read and write (quotes, outcomes, merges)
   - Issues: Read and write (doorbell issue replies, mentions)
   - Discussions: Read and write (weekly digest)
   - Metadata: Read-only (set automatically)
   No organisation or account permissions.
5. **Where can this GitHub App be installed:** Only on this account.
6. Create the App. Note the **App ID** on its settings page.
7. **Private keys**, Generate a private key. A `.pem` file downloads. Move it to the server's secrets directory with permissions `600`. It is never committed and never pasted into chat.
8. **Install App**, choose the organisation, **Only select repositories**, pick `nomicon-sim` now and `nomicon` at launch. The installation id is the last number in the resulting URL (`.../settings/installations/<id>`); it is optional, the agent resolves it from the repository when unset.

## Configuring the agent

Set, instead of `GITHUB_TOKEN`:

    GITHUB_APP_ID=<app id>
    GITHUB_APP_PRIVATE_KEY=/path/to/nomicon-agent.pem
    GITHUB_APP_INSTALLATION_ID=<optional>

On start the agent logs `github identity: nomicon-agent[bot] (<numeric id>)` and refuses to run if that id differs from the agent account named in the ledger's genesis event. For a new ledger, `nomicon genesis` records the App's id automatically when `NOMICON_AGENT_ACCOUNT` is unset. The numeric id also goes into `NOTICES.md`.

Testing the App on `nomicon-sim` needs a fresh genesis there, since its current ledger names a personal account as the agent.

## Rotating the key

Generate a new private key on the App's settings page, install it on the server, restart the agent, then delete the old key on GitHub. Nothing in the ledger changes; the ledger signing key is a different key.
