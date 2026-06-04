import { LoginScreen } from "./LoginScreen";

export function AuthResolvingScreen({
  onLogin,
  onLoginFallback,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  return (
    <LoginScreen
      onLogin={onLogin}
      onLoginFallback={onLoginFallback}
      isCheckingSession={true}
    />
  );
}
