const fs = require("fs");
const path = require("path");

app.get("/install.sh", (req, res) => {
  const installPath = path.join(__dirname, "install.sh");

  if (!fs.existsSync(installPath)) {
    return res.status(404).send("install.sh not found");
  }

  res.setHeader("Content-Type", "text/plain");
  fs.createReadStream(installPath).pipe(res);
});