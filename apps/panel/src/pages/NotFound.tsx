import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { EmptyState } from "../components/ui";

export function NotFoundPage() {
  return (
    <div className="page">
      <EmptyState
        icon={Compass}
        title="沒有這個頁面"
        actions={
          <Link to="/" className="btn btn--sm">
            回到總覽
          </Link>
        }
      >
        網址可能打錯了,或這個頁面已經搬家。
      </EmptyState>
    </div>
  );
}
