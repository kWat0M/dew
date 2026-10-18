fn main() {
    let d = std::env::args().nth(1).unwrap();
    let t = std::time::Instant::now();
    match dew_capture::monitor::connect(d.trim_start_matches(':').parse().unwrap()) {
        Ok((c, s)) => {
            use x11rb::connection::Connection;
            println!("ok in {:?} root={}", t.elapsed(), c.setup().roots[s].root)
        }
        Err(e) => println!("err in {:?}: {e}", t.elapsed()),
    }
}
