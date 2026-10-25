fn main() {
    std::process::exit(striart_native::cli::run(
        std::env::args_os().skip(1).collect(),
    ));
}
