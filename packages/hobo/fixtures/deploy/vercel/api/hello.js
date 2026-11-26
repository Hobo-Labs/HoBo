// Default Vercel Node function for createVercelDeployProvider.
// Mirrors hello-bindle GET /hello?name= -> { message: "hello, <name>" } (default "world").
export default function handler(req, res) {
	const raw = req.query?.name || "";
	const name = String(raw).trim() || "world";
	res.setHeader("content-type", "application/json");
	res.status(200).json({ message: `hello, ${name}` });
}
