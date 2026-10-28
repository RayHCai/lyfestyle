// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    // `lyfestyle --mcp --data-dir <dir>` is the agent's tool server, not the window.
    if args.next().as_deref() == Some("--mcp") {
        return lyfestyle_lib::mcp::serve(args);
    }
    lyfestyle_lib::run()
}
