import { useParams } from "react-router";
import { api, useLoad } from "../api.ts";
import { ErrorBox, Spinner } from "../components.tsx";
import { useSession } from "../session.tsx";
import { RepoList } from "./Home.tsx";

export function UserPage() {
  const { owner = "" } = useParams();
  const { me } = useSession();
  const repos = useLoad(() => api.userRepos(owner), `user:${owner}`);
  const isMe = me?.user?.login.toLowerCase() === owner.toLowerCase();
  return (
    <div className="narrow">
      <h1>{owner}</h1>
      {repos.error ? (
        <ErrorBox error={repos.error} />
      ) : repos.loading ? (
        <Spinner />
      ) : (
        <RepoList repos={repos.data ?? []} empty={isMe ? "You have no repositories yet." : "No public repositories."} />
      )}
    </div>
  );
}
