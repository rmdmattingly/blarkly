# ![Blarkly logo](frontend/public/logo.png)

**Forgot a deck of cards? Don't let that stop family game night**

![High / Low](highlow.png)

## Build & Deploy

Run the following commands from the repo root when you're ready to publish:

```bash
cd functions && npm run build && cd ..
cd frontend && npm run build && cd ..
firebase deploy --only hosting,functions
```
